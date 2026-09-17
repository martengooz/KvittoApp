/**
 * A pairing payload, as carried by the QR code the web app shows.
 *
 * Accepted as a `kvitto://pair?...` URL or as the JSON object behind it, since
 * a user reading a code aloud or pasting from a message may produce either.
 */
export interface PairingPayload {
  serverUrl: string;
  token: string;
  accountId: string | null;
  deviceName: string | null;
}

export type PairingParseResult =
  | { ok: true; payload: PairingPayload }
  | { ok: false; reason: string };

/**
 * A pairing token is a bearer credential. It is never logged, never put in a
 * route parameter, and never echoed back in an error message - an error that
 * quotes the input would put it wherever the error is shown.
 */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function validate(
  serverUrl: string | null,
  token: string | null,
  accountId: string | null,
  deviceName: string | null,
): PairingParseResult {
  if (!serverUrl) return { ok: false, reason: 'The code is missing a server address.' };
  if (!token) return { ok: false, reason: 'The code is missing a pairing token.' };

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return { ok: false, reason: 'The server address is not a valid URL.' };
  }

  // A pairing token is sent to this host on every sync. Allowing http would
  // hand it to anyone on the network, so it is refused rather than warned about.
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'The server address must use https.' };
  }

  return {
    ok: true,
    payload: { serverUrl: parsed.toString(), token, accountId, deviceName },
  };
}

export function parsePairingPayload(raw: string): PairingParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'Nothing was scanned or entered.' };

  if (trimmed.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: 'The code is not readable pairing data.' };
    }
    if (typeof json !== 'object' || json === null) {
      return { ok: false, reason: 'The code is not readable pairing data.' };
    }
    const record = json as Record<string, unknown>;
    return validate(
      readString(record.serverUrl),
      readString(record.token),
      readString(record.accountId),
      readString(record.deviceName),
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'The code is not readable pairing data.' };
  }

  if (url.protocol !== 'kvitto:') {
    return { ok: false, reason: 'That is not a KvittoApp pairing code.' };
  }

  return validate(
    readString(url.searchParams.get('server')),
    readString(url.searchParams.get('token')),
    readString(url.searchParams.get('account')),
    readString(url.searchParams.get('device')),
  );
}
