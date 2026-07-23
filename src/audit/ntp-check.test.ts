import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateSocket = vi.hoisted(() => vi.fn());

vi.mock('node:dgram', () => ({
  createSocket: mockCreateSocket,
}));

import { checkNtpClock } from './ntp-check.js';

class FakeSocket extends EventEmitter {
  readonly close = vi.fn();
  readonly send = vi.fn();
}

function ntpPacket(timestamps: { originate: number; receive: number; transmit: number }): Buffer {
  const packet = Buffer.alloc(48);
  for (const [offset, timestamp] of [
    [24, timestamps.originate],
    [32, timestamps.receive],
    [40, timestamps.transmit],
  ] as const) {
    const seconds = Math.floor(timestamp) + 2208988800;
    const fraction = Math.round((timestamp - Math.floor(timestamp)) * 0xffffffff);
    packet.writeUInt32BE(seconds, offset);
    packet.writeUInt32BE(fraction, offset + 4);
  }
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
    it('returns the computed offset and round trip from a valid response', async () => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_200);

      const resultPromise = checkNtpClock(['ntp.example']);
      socket.emit('message', ntpPacket({ originate: 100, receive: 100.1, transmit: 100.15 }));

      await expect(resultPromise).resolves.toEqual({
        offsetMs: -50,
        server: 'ntp.example',
        driftWarned: false,
        roundTripMs: 250,
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(socket.send).toHaveBeenCalledWith(expect.any(Buffer), 0, 48, 123, 'ntp.example');
    });
  });

  describe('BAD', () => {
    it('returns the documented fallback after a short response', async () => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);

      const resultPromise = checkNtpClock(['ntp.example']);
      socket.emit('message', Buffer.alloc(47));

      await expect(resultPromise).resolves.toEqual({
        offsetMs: 0,
        server: 'ntp.example',
        driftWarned: false,
        roundTripMs: 0,
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('returns the documented fallback after a synchronous send error', async () => {
      const socket = new FakeSocket();
      socket.send.mockImplementation(() => {
        throw new Error('send failed');
      });
      mockCreateSocket.mockReturnValue(socket);

      await expect(checkNtpClock(['ntp.example'])).resolves.toMatchObject({
        server: 'ntp.example',
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('returns the documented fallback after a socket error', async () => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);

      const resultPromise = checkNtpClock(['ntp.example']);
      socket.emit('error', new Error('network unavailable'));

      await expect(resultPromise).resolves.toMatchObject({
        server: 'ntp.example',
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('settles a malformed response immediately without leaving its timeout active', async () => {
      vi.useFakeTimers();
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);

      const resultPromise = checkNtpClock(['ntp.example']);
      socket.emit('message', Buffer.alloc(47));

      await expect(resultPromise).resolves.toMatchObject({
        error: 'All NTP servers unreachable: ntp.example',
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles a synchronous send failure immediately without leaving its timeout active', async () => {
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
  });

  describe('CORNER', () => {
    it('uses the default server when the configured server list is empty', async () => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);

      const resultPromise = checkNtpClock([]);
      socket.emit('message', ntpPacket({ originate: 100, receive: 100, transmit: 100 }));

      await expect(resultPromise).resolves.toMatchObject({ server: 'pool.ntp.org' });
      expect(socket.send).toHaveBeenCalledWith(expect.any(Buffer), 0, 48, 123, 'pool.ntp.org');
    });

    it('warns only when the offset is greater than the drift threshold', async () => {
      const thresholdSocket = new FakeSocket();
      mockCreateSocket.mockReturnValue(thresholdSocket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);
      const thresholdResult = checkNtpClock(['ntp.example'], undefined, 50);
      thresholdSocket.emit(
        'message',
        ntpPacket({ originate: 100.05, receive: 100.05, transmit: 100.05 }),
      );
      await expect(thresholdResult).resolves.toMatchObject({ driftWarned: false, offsetMs: 50 });

      const aboveThresholdSocket = new FakeSocket();
      mockCreateSocket.mockReturnValue(aboveThresholdSocket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);
      const aboveThresholdResult = checkNtpClock(['ntp.example'], undefined, 50);
      aboveThresholdSocket.emit(
        'message',
        ntpPacket({ originate: 100.051, receive: 100.051, transmit: 100.051 }),
      );
      await expect(aboveThresholdResult).resolves.toMatchObject({ driftWarned: true });
    });
  });

  describe('EDGE', () => {
    it('uses only the first valid response and closes its socket once', async () => {
      const socket = new FakeSocket();
      mockCreateSocket.mockReturnValue(socket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);

      const resultPromise = checkNtpClock(['ntp.example']);
      socket.emit('message', ntpPacket({ originate: 100, receive: 100, transmit: 100 }));
      socket.emit('message', ntpPacket({ originate: 101, receive: 101, transmit: 101 }));

      await expect(resultPromise).resolves.toMatchObject({ server: 'ntp.example', offsetMs: 0 });
      expect(socket.close).toHaveBeenCalledTimes(1);
    });

    it('falls back to the next server and ignores late events from the failed socket', async () => {
      const firstSocket = new FakeSocket();
      const secondSocket = new FakeSocket();
      mockCreateSocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
      vi.spyOn(Date, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(100_000);

      const resultPromise = checkNtpClock(['first.example', 'second.example']);
      firstSocket.emit('error', new Error('first failed'));
      await vi.waitFor(() => expect(mockCreateSocket).toHaveBeenCalledTimes(2));
      firstSocket.emit('message', ntpPacket({ originate: 100, receive: 100, transmit: 100 }));
      secondSocket.emit('message', ntpPacket({ originate: 100, receive: 100, transmit: 100 }));

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
