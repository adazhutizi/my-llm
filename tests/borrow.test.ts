import { describe, it, expect } from 'vitest';
import { isBorrowActive, isBorrowExpired } from '../src/services/borrow.js';

const now = new Date('2026-10-30T12:00:00Z');

describe('isBorrowActive', () => {
  it('returns false when no borrowed key exists', () => {
    expect(isBorrowActive({ hasBorrowedKey: false, borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: null }, now)).toBe(false);
  });

  it('returns false when borrowed provider id is missing', () => {
    expect(isBorrowActive({ hasBorrowedKey: true, borrowedProviderId: null, borrowStartAt: null, borrowExpiresAt: null }, now)).toBe(false);
  });

  it('returns true for an open-ended borrow starting immediately (null start/expiry)', () => {
    expect(isBorrowActive({ hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: null }, now)).toBe(true);
    // start at the current instant counts as started
    expect(isBorrowActive({ hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: now, borrowExpiresAt: null }, now)).toBe(true);
  });

  it('returns false while the scheduled start time is in the future (pre-set borrow)', () => {
    expect(
      isBorrowActive(
        { hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: new Date('2026-10-30T13:00:00Z'), borrowExpiresAt: new Date('2026-10-31T00:00:00Z') },
        now,
      ),
    ).toBe(false);
  });

  it('returns true once the start time has passed', () => {
    expect(
      isBorrowActive(
        { hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: new Date('2026-10-30T11:00:00Z'), borrowExpiresAt: new Date('2026-10-31T00:00:00Z') },
        now,
      ),
    ).toBe(true);
  });

  it('returns false when expiry is in the past (equal instant counts as expired)', () => {
    expect(
      isBorrowActive(
        { hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: new Date('2026-10-30T12:00:00Z') },
        now,
      ),
    ).toBe(false);
    expect(
      isBorrowActive(
        { hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: new Date('2026-10-29T00:00:00Z') },
        now,
      ),
    ).toBe(false);
  });

  it('treats empty-string borrowed key as no borrow (defensive)', () => {
    // hasBorrowedKey 是调用方从 !!key 推出的布尔；空串 key 视为无借用
    expect(isBorrowActive({ hasBorrowedKey: Boolean(''), borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: null }, now)).toBe(false);
  });
});

describe('isBorrowExpired', () => {
  it('returns false when there is no borrowed key', () => {
    expect(isBorrowExpired({ hasBorrowedKey: false, borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: new Date('2026-10-29T00:00:00Z') }, now)).toBe(false);
  });

  it('returns false for an open-ended borrow (no expiry = nothing to expire)', () => {
    expect(isBorrowExpired({ hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: null }, now)).toBe(false);
  });

  it('returns true only after the expiry has passed', () => {
    expect(
      isBorrowExpired(
        { hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: new Date('2026-10-30T12:00:00Z') },
        now,
      ),
    ).toBe(true);
    expect(
      isBorrowExpired(
        { hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: null, borrowExpiresAt: new Date('2026-10-31T00:00:00Z') },
        now,
      ),
    ).toBe(false);
  });

  it('a scheduled (not yet started) borrow with a passed window counts as expired', () => {
    // 窗口整体过去（start 与 expire 都在未来/过去边界外）→ 可惰性清除
    expect(
      isBorrowExpired(
        { hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: new Date('2026-10-28T00:00:00Z'), borrowExpiresAt: new Date('2026-10-29T00:00:00Z') },
        now,
      ),
    ).toBe(true);
  });

  it('a scheduled borrow whose window has NOT passed is NOT expired (must not be lazily cleared)', () => {
    expect(
      isBorrowExpired(
        { hasBorrowedKey: true, borrowedProviderId: 5, borrowStartAt: new Date('2026-10-30T13:00:00Z'), borrowExpiresAt: new Date('2026-10-31T00:00:00Z') },
        now,
      ),
    ).toBe(false);
  });
});
