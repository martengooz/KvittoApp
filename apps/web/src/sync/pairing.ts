/**
 * The pairing handshake: redeem a code for a token, store it, and kick off the
 * first sync.
 *
 * Both places a code can come from — typed into the settings form, or decoded
 * from a QR code — end the same way, so this is the one function each calls
 * rather than repeating the sequence with its own toast wording.
 */

import { toast } from '../core/toast.js';
import { pairDevice } from './client.js';
import { sync } from './engine.js';
import { setDeviceToken } from './identity.js';

export async function pairAndSync(serverUrl: string, code: string): Promise<void> {
  const result = await pairDevice(serverUrl, code);
  await setDeviceToken(result.token, result.accountId);
  toast('Enheten är parkopplad.', { kind: 'success' });
  void sync();
}
