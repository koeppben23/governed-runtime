import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateSocket = vi.hoisted(() => vi.fn());

vi.mock('node:dgram', () => ({ createSocket: mockCreateSocket }));

import { checkNtpClock } from './ntp-check.js';

class FakeSocket extends EventEmitter {
  readonly close = vi.fn();
  readonly connect = vi.fn((_port: number, _server: string, callback: () => void) => callback());
  readonly send = vi.fn();
}

function writeTimestamp(packet: Buffer, offset: number, timestamp: number): void {
  const seconds = Math.floor(timestamp) + 2208988800;
  const fraction = Math.round((timestamp - Math.floor(timestamp)) * 0xffffffff);
  packet.writeUInt32BE(seconds, offset);
  packet.writeUInt32BE(fraction, offset + 4);
}

function ntpResponse(
  socket: FakeSocket,
  timestamps: { receive: number; transmit: number },
  options: { header?: number; stratum?: number; originate?: Buffer; nullTransmit?: boolean } = {},
): Buffer {
  const packet = Buffer.alloc(48);
  packet[0] = options.header ?? 0x24; // LI=0, VN=4, server mode.
  packet[1] = options.stratum ?? 1;
  packet.set(
    options.originate ?? Buffer.from(socket.send.mock.calls[0]?.[0].subarray(40, 48) ?? []),
    24,
  );
  writeTimestamp(packet, 32, timestamps.receive);
  if (!options.nullTransmit) writeTimestamp(packet, 40, timestamps.transmit);
  return packet;
}

describe('checkNtpClock', () => {
  beforeEach(() => {
    mockCreateSocket.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('HAPPY', () => {
    it('binds a valid server response to its request and uses the RFC four-timestamp offset', async () => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_200);

      const resultPromise = checkNtpClock(['ntp.example']);
      const response = ntpResponse(socket, { receive: 100.1, transmit: 100.15 });
      expect(response.subarray(24, 32)).toEqual(socket.send.mock.calls[0]?.[0].subarray(40, 48));
      socket.emit('message', response);

      await expect(resultPromise).resolves.toEqual({
        offsetMs: 25,
        server: 'ntp.example',
        driftWarned: false,
        roundTripMs: 150,
      });
      expect(socket.connect).toHaveBeenCalledWith(123, 'ntp.example', expect.any(Function));
      expect(socket.send).toHaveBeenCalledWith(expect.any(Buffer));
      expect(socket.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('BAD', () => {
    it('returns the documented fallback after a short response', async () => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);

      const resultPromise = checkNtpClock(['ntp.example']);
      socket.emit('message', Buffer.alloc(47));

      await expect(resultPromise).resolves.toMatchObject({
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['unsynchronized leap indicator', { header: 0xe4 }],
      ['unsupported version', { header: 0x14 }],
      ['non-server mode', { header: 0x23 }],
      ['kiss-o-death stratum', { stratum: 0 }],
      ['unsynchronized stratum', { stratum: 16 }],
      ['non-matching origin timestamp', { originate: Buffer.alloc(8, 1) }],
      ['null transmit timestamp', { nullTransmit: true }],
    ])('rejects a response with %s', async (_description, options) => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);

      const resultPromise = checkNtpClock(['ntp.example']);
      socket.emit('message', ntpResponse(socket, { receive: 100, transmit: 100 }, options));

      await expect(resultPromise).resolves.toMatchObject({
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('settles a synchronous send failure immediately without retaining its timeout', async () => {
      vi.useFakeTimers();
      const socket = new FakeSocket();
      socket.send.mockImplementation(() => {
        throw new Error('send failed');
      });
      mockCreateSocket.mockReturnValue(socket);

      await expect(checkNtpClock(['ntp.example'])).resolves.toMatchObject({
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles a synchronous peer connection failure immediately without retaining its timeout', async () => {
      vi.useFakeTimers();
      const socket = new FakeSocket();
      socket.connect.mockImplementation(() => {
        throw new Error('connect failed');
      });
      mockCreateSocket.mockReturnValue(socket);

      await expect(checkNtpClock(['ntp.example'])).resolves.toMatchObject({
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.send).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('CORNER', () => {
    it('uses the default server when the configured server list is empty', async () => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);

      const resultPromise = checkNtpClock([]);
      socket.emit('message', ntpResponse(socket, { receive: 100, transmit: 100 }));

      await expect(resultPromise).resolves.toMatchObject({ server: 'pool.ntp.org' });
      expect(socket.connect).toHaveBeenCalledWith(123, 'pool.ntp.org', expect.any(Function));
    });

    it('warns only when the offset is greater than the drift threshold', async () => {
      const thresholdSocket = new FakeSocket();
      mockCreateSocket.mockReturnValue(thresholdSocket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);
      const thresholdResult = checkNtpClock(['ntp.example'], undefined, 50);
      thresholdSocket.emit(
        'message',
        ntpResponse(thresholdSocket, { receive: 100.05, transmit: 100.05 }),
      );
      await expect(thresholdResult).resolves.toMatchObject({ driftWarned: false, offsetMs: 50 });

      const aboveThresholdSocket = new FakeSocket();
      mockCreateSocket.mockReturnValue(aboveThresholdSocket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);
      const aboveThresholdResult = checkNtpClock(['ntp.example'], undefined, 50);
      aboveThresholdSocket.emit(
        'message',
        ntpResponse(aboveThresholdSocket, { receive: 100.051, transmit: 100.051 }),
      );
      await expect(aboveThresholdResult).resolves.toMatchObject({ driftWarned: true });
    });
  });

  describe('EDGE', () => {
    it('falls back after an invalid response and accepts a bound response from the next server', async () => {
      const firstSocket = new FakeSocket();
      const secondSocket = new FakeSocket();
      mockCreateSocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);

      const resultPromise = checkNtpClock(['first.example', 'second.example']);
      firstSocket.emit(
        'message',
        ntpResponse(firstSocket, { receive: 100, transmit: 100 }, { stratum: 0 }),
      );
      await vi.waitFor(() => expect(mockCreateSocket).toHaveBeenCalledTimes(2));
      secondSocket.emit('message', ntpResponse(secondSocket, { receive: 100, transmit: 100 }));

      await expect(resultPromise).resolves.toMatchObject({ server: 'second.example' });
      expect(firstSocket.close).toHaveBeenCalledTimes(1);
      expect(secondSocket.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('PERF', () => {
    it('settles a timeout without retaining an active timer', async () => {
      vi.useFakeTimers();
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);

      const resultPromise = checkNtpClock(['ntp.example'], 10);
      await vi.advanceTimersByTimeAsync(10);

      await expect(resultPromise).resolves.toMatchObject({
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
