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

export interface NtpCheckResult {
  readonly offsetMs: number;
  readonly server: string;
  readonly driftWarned: boolean;
  readonly roundTripMs: number;
  readonly error?: string;
}

function buildNtpPacket(): Buffer {
  const buf = Buffer.alloc(NTP_PACKET_SIZE);
  buf[0] = 0x1b;
  return buf;
}

function parseNtpTimestamp(buf: Buffer, offset: number): number {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  return seconds + fraction / 0xffffffff - NTP_EPOCH_OFFSET;
}

async function querySingleServer(
  server: string,
  timeoutMs: number,
): Promise<{ server: string; offsetMs: number; roundTripMs: number }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const sendTime = Date.now();
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.close();
        reject(new Error(`NTP query timeout for ${server}`));
      }
    }, timeoutMs);

    socket.on('message', (msg: Buffer) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket.close();

      const receiveTime = Date.now();
      const originateTimestamp = parseNtpTimestamp(msg, 24);
      const receiveTimestamp = parseNtpTimestamp(msg, 32);
      const transmitTimestamp = parseNtpTimestamp(msg, 40);

      const t1 = sendTime / 1000;
      const t4 = receiveTime / 1000;
      const roundTrip = t4 - t1 - (receiveTimestamp - transmitTimestamp);
      const offset = (originateTimestamp - t1 + receiveTimestamp - t4) / 2;
      const roundTripMs = Math.round(Math.abs(roundTrip) * 1000);

      resolve({
        server,
        offsetMs: Math.round(offset * 1000),
        roundTripMs,
      });
    });

    socket.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.close();
        reject(err);
      }
    });

    const packet = buildNtpPacket();
    socket.send(packet, 0, packet.length, NTP_PORT, server);
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
