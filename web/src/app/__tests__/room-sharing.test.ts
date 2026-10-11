import { describe, it, expect } from 'vitest';
import { localOnlyAddress, messagesLink } from '../rooms/api.ts';
describe('online game invitations', () => {
  it('does not share localhost, LAN, or unencrypted development addresses as phone invitations', () => {
    for (const url of ['http://localhost:5173/#/room/a', 'https://localhost:5173', 'http://127.0.0.1:5173', 'http://192.168.1.2:5173']) expect(localOnlyAddress(url)).toBe(true);
    expect(localOnlyAddress('https://draw-play.example/#/room/a')).toBe(false);
  });
  it('composes the uploaded draft command instead of the local draft or player ticket', () => {
    expect(messagesLink('+15551234567', 'd_87654321')).toBe('sms:+15551234567&body=play%20d_87654321');
  });
});
