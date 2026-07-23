/**
 * @module audit/ntp-check
 * @description Lightweight NTP clock validation — low-assurance advisory evidence.
 *
 * NTP is a drift/sanity check, not a trusted timestamp authority.
 * It never blocks session operations and never claims legal weight.
 *
 * Uses Node.js `dgram` for UDP NTP queries (RFC 5905 SNTP subset).
 * Failures are non-blocking: if NTP is unreachable, the result carries
 * an error field and callers continue with local time.
 *
 * @version v1
 */

import * as dgram from 'node:dgram';

const NTP_DEFAULT_SERVERS = ['pool.ntp.org'];
const NTP_DEFAULT_TIMEOUT_MS = 5000;
const NTP_PORT = 123;
const NTP_PACKET_SIZE = 48;
const NTP_EPOCH_OFFSET = 2208988800;
const NTP_CLIENT_MODE = 3;
const NTP_SERVER_MODE = 4;
const NTP_VERSION = 4;
const NTP_MIN_COMPATIBLE_VERSION = 3;
const NTP_MAX_STRATUM = 15;
const NTP_FRACTION_SCALE = 2 ** 32;
const ZERO_NTP_TIMESTAMP = Buffer.alloc(8);

export interface NtpCheckResult {
  readonly offsetMs: number;
  readonly server: string;
  readonly driftWarned: boolean;
  readonly roundTripMs: number;
  readonly error?: string;
}

function writeNtpTimestamp(buf: Buffer, offset: number, unixTimeMs: number): void {
  const unixSeconds = unixTimeMs / 1000;
  const seconds = Math.floor(unixSeconds) + NTP_EPOCH_OFFSET;
  const fraction = Math.round((unixSeconds - Math.floor(unixSeconds)) * NTP_FRACTION_SCALE);
  buf.writeUInt32BE(seconds, offset);
  buf.writeUInt32BE(fraction, offset + 4);
}

function buildNtpPacket(sendTimeMs: number): Buffer {
  const buf = Buffer.alloc(NTP_PACKET_SIZE);
  buf[0] = (NTP_VERSION << 3) | NTP_CLIENT_MODE;
  writeNtpTimestamp(buf, 40, sendTimeMs);
  return buf;
}

function parseNtpTimestamp(buf: Buffer, offset: number): number {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  return seconds + fraction / NTP_FRACTION_SCALE - NTP_EPOCH_OFFSET;
}

function validateNtpResponse(
  msg: Buffer,
  server: string,
  requestTransmitTimestamp: Buffer,
): { receiveTimestamp: number; transmitTimestamp: number } {
  if (msg.length < NTP_PACKET_SIZE) {
    throw new Error(`NTP response from ${server} is shorter than ${NTP_PACKET_SIZE} bytes`);
  }

  const header = msg[0]!;
  const leapIndicator = header >> 6;
  const version = (header >> 3) & 0x07;
  const mode = header & 0x07;
  const stratum = msg[1]!;
  const originateTimestampBytes = msg.subarray(24, 32);
  const transmitTimestampBytes = msg.subarray(40, 48);

  if (leapIndicator === 3) throw new Error(`NTP response from ${server} is unsynchronized`);
  if (version < NTP_MIN_COMPATIBLE_VERSION || version > NTP_VERSION) {
    throw new Error(`NTP response from ${server} has unsupported version ${version}`);
  }
  if (mode !== NTP_SERVER_MODE)
    throw new Error(`NTP response from ${server} has unexpected mode ${mode}`);
  if (stratum === 0 || stratum > NTP_MAX_STRATUM) {
    throw new Error(`NTP response from ${server} has invalid stratum ${stratum}`);
  }
  if (!originateTimestampBytes.equals(requestTransmitTimestamp)) {
    throw new Error(`NTP response from ${server} does not match the request timestamp`);
  }
  if (transmitTimestampBytes.equals(ZERO_NTP_TIMESTAMP)) {
    throw new Error(`NTP response from ${server} has no transmit timestamp`);
  }

  return {
    receiveTimestamp: parseNtpTimestamp(msg, 32),
    transmitTimestamp: parseNtpTimestamp(msg, 40),
  };
}

async function querySingleServer(
  server: string,
  timeoutMs: number,
): Promise<{ server: string; offsetMs: number; roundTripMs: number }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let sendTime: number | undefined;
    let requestTransmitTimestamp: Buffer | undefined;
    let resolved = false;

    function cleanup(): void {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The request result is authoritative; cleanup must not replace it.
      }
    }

    function fail(error: Error): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(error);
    }

    const timer = setTimeout(() => {
      fail(new Error(`NTP query timeout for ${server}`));
    }, timeoutMs);

    socket.on('message', (msg: Buffer) => {
      if (resolved) return;
      // Do not accept a response before the request has been transmitted.
      if (sendTime === undefined || requestTransmitTimestamp === undefined) return;
      try {
        const receiveTime = Date.now();
        const { receiveTimestamp, transmitTimestamp } = validateNtpResponse(
          msg,
          server,
          requestTransmitTimestamp,
        );

        const t4 = receiveTime / 1000;
        const roundTrip = t4 - sendTime - (transmitTimestamp - receiveTimestamp);
        const offset = (receiveTimestamp - sendTime + transmitTimestamp - t4) / 2;
        const roundTripMs = Math.round(Math.abs(roundTrip) * 1000);

        resolved = true;
        cleanup();
        resolve({
          server,
          offsetMs: Math.round(offset * 1000),
          roundTripMs,
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.on('error', (err: Error) => {
      fail(err);
    });

    try {
      // A connected UDP socket accepts packets only from this peer.
      socket.connect(NTP_PORT, server, () => {
        if (resolved) return;
        try {
          const sendTimeMs = Date.now();
          sendTime = sendTimeMs / 1000;
          const packet = buildNtpPacket(sendTimeMs);
          requestTransmitTimestamp = Buffer.from(packet.subarray(40, 48));
          socket.send(packet);
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Check the local clock against NTP servers.
 *
 * On success: returns offset, server used, drift warning flag.
 * On failure: returns offset=0 and error message. Never throws.
 *
 * @param servers - NTP server hostnames (default: pool.ntp.org).
 * @param timeoutMs - Per-server query timeout (default: 5000ms).
 */
export async function checkNtpClock(
  servers?: readonly string[],
  timeoutMs?: number,
  ntpDriftThresholdMs?: number,
): Promise<NtpCheckResult> {
  const targets = servers && servers.length > 0 ? servers : NTP_DEFAULT_SERVERS;
  const timeout = timeoutMs ?? NTP_DEFAULT_TIMEOUT_MS;
  const threshold = ntpDriftThresholdMs ?? 30000;

  for (const server of targets) {
    try {
      const result = await querySingleServer(server, timeout);
      return {
        offsetMs: result.offsetMs,
        server: result.server,
        driftWarned: Math.abs(result.offsetMs) > threshold,
        roundTripMs: result.roundTripMs,
      };
    } catch {
      continue;
    }
  }

  return {
    offsetMs: 0,
    server: targets.join(','),
    driftWarned: false,
    roundTripMs: 0,
    error: `All NTP servers unreachable: ${targets.join(', ')}`,
  };
}
