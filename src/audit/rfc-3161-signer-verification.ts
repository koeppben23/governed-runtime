/**
 * @module audit/rfc-3161-signer-verification
 * @description TSA signer contract and CMS signature verification stages.
 *
 * TSA signer contract (TSA1/TSA3): exactly one critical, exclusive
 * id-kp-timeStamping EKU; unknown critical extensions reject. CMS signatures
 * must be internally coherent: content-type and message-digest signed
 * attributes bind the TSTInfo, the signing certificate binding is checked
 * (ESS), and the messageImprint compares in constant time.
 *
 * @version v1
 */

import * as asn1js from 'asn1js';
import { getCrypto, type Certificate } from 'pkijs';
import { verifySigningCertificateBinding } from './rfc-3161-ess-binding.js';
import {
  extractAttributeValue,
  invalid,
  sameBytes,
  OID_CONTENT_TYPE,
  OID_EKU,
  OID_KP_TIMESTAMPING,
  OID_MESSAGE_DIGEST,
  OID_TST_INFO,
  UNDERSTOOD_CRITICAL_EXTENSIONS,
  type InvalidResult,
  type ParsedToken,
  type VerificationReason,
} from './rfc-3161-token-parse.js';

// ─── TSA1/TSA3: signer certificate contract ──────────────────────────────────

function parseEkuPurposes(eku: { readonly extnValue: asn1js.OctetString }): string[] | null {
  try {
    const parsed = asn1js.fromBER(eku.extnValue.valueBlock.valueHexView);
    // Covered by the EKU negative tests (missing/non-critical/extra);
    // unparseable purposes land in the same missing_tsa_eku rejection.
    // Stryker disable next-line ConditionalExpression,UnaryOperator
    if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) return null;
    const purposes: string[] = [];
    for (const item of parsed.result.valueBlock.value) {
      // Stryker disable next-line ConditionalExpression
      if (!(item instanceof asn1js.ObjectIdentifier)) return null;
      purposes.push(item.valueBlock.toString());
    }
    return purposes;
  } catch {
    return null;
  }
}

/**
 * TSA signer contract (TSA1/TSA3): exclusive, critical id-kp-timeStamping EKU;
 * unknown critical extensions reject.
 */
export function checkTsaSignerContract(
  signer: Certificate,
): { decision: true } | { rejection: InvalidResult } {
  const extensions = signer.extensions ?? [];
  const ekus = extensions.filter((extension) => extension.extnID === OID_EKU);
  const eku = ekus[0];
  if (!eku) {
    return {
      rejection: invalid(
        'missing_tsa_eku',
        'signer certificate carries no extendedKeyUsage extension',
      ),
    };
  }
  if (ekus.length !== 1) {
    return {
      rejection: invalid(
        'duplicate_tsa_eku',
        'signer certificate must carry exactly one extendedKeyUsage extension (RFC 3161 §2.3)',
      ),
    };
  }
  if (eku.critical !== true) {
    return {
      rejection: invalid(
        'missing_tsa_eku',
        'extendedKeyUsage is not marked critical (RFC 3161 §2.3)',
      ),
    };
  }
  const purposes = parseEkuPurposes(eku);
  if (!purposes) {
    return { rejection: invalid('missing_tsa_eku', 'extendedKeyUsage could not be parsed') };
  }
  if (!purposes.includes(OID_KP_TIMESTAMPING)) {
    return {
      rejection: invalid(
        'missing_tsa_eku',
        `extendedKeyUsage misses id-kp-timeStamping (${OID_KP_TIMESTAMPING})`,
      ),
    };
  }
  const extra = purposes.filter((purpose) => purpose !== OID_KP_TIMESTAMPING);
  if (extra.length > 0) {
    return {
      rejection: invalid(
        'non_exclusive_tsa_eku',
        `additional key purposes present: ${extra.join(', ')}`,
      ),
    };
  }
  for (const extension of extensions) {
    if (extension.critical && !UNDERSTOOD_CRITICAL_EXTENSIONS.has(extension.extnID)) {
      return {
        rejection: invalid(
          'unhandled_critical_extension',
          `unknown critical extension ${extension.extnID}`,
        ),
      };
    }
  }
  return { decision: true };
}

// ─── CMS signature verification ──────────────────────────────────────────────

export async function verifyCmsSignature(
  parsed: ParsedToken,
  signer: Certificate,
  hashName: string,
): Promise<{ valid: boolean; reason?: VerificationReason }> {
  const signerInfo = parsed.signedData.signerInfos[0];
  if (!signerInfo) return { valid: false, reason: 'missing_signer_info' };
  const crypto = getCrypto(true);

  if (signerInfo.signedAttrs?.attributes) {
    const ctValue = extractAttributeValue(signerInfo.signedAttrs.attributes, OID_CONTENT_TYPE);
    if (!ctValue) return { valid: false, reason: 'signed_attrs_invalid' };

    const oidBlock = new asn1js.ObjectIdentifier({ value: OID_TST_INFO });
    const expectedCt = (oidBlock as unknown as { toBER(): ArrayBuffer }).toBER();
    if (!sameBytes(expectedCt, ctValue)) return { valid: false, reason: 'signed_attrs_invalid' };

    const mdValue = extractAttributeValue(signerInfo.signedAttrs.attributes, OID_MESSAGE_DIGEST);
    if (!mdValue) return { valid: false, reason: 'signed_attrs_invalid' };

    const computedMd = await crypto.digest({ name: hashName }, new Uint8Array(parsed.tstInfoDer));
    if (!sameBytes(computedMd, mdValue)) return { valid: false, reason: 'signed_attrs_invalid' };
    if (!(await verifySigningCertificateBinding(signerInfo.signedAttrs.attributes, signer))) {
      return { valid: false, reason: 'signing_certificate_invalid' };
    }

    const signedAttrsDer = signerInfo.signedAttrs.toSchema().toBER();
    const view = new Uint8Array(signedAttrsDer);
    view[0] = 0x31;
    const sigOk = await crypto.verifyWithPublicKey(
      view.buffer,
      signerInfo.signature,
      signer.subjectPublicKeyInfo,
      signerInfo.signatureAlgorithm,
      hashName,
    );
    return sigOk ? { valid: true } : { valid: false, reason: 'untrusted_cert' };
  }

  return { valid: false, reason: 'signing_certificate_invalid' };
}
