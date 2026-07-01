// Twilio request-signature verification (https://www.twilio.com/docs/usage/security#validating-requests).
// Twilio signs each webhook as base64(HMAC-SHA1(url + sorted-concatenated-params, authToken)),
// sent in the `X-Twilio-Signature` header. Hand-rolled (no `twilio` dependency) to match the
// house style — mirrors slack/verify.mjs, but Twilio's algorithm differs (SHA1 + URL+params).
import crypto from 'node:crypto';

/** The string Twilio signs: the full webhook URL followed by each POST param (sorted by key) as key+value. */
export function twilioSignatureBase(url, params) {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return data;
}

export function verifyTwilioSignature({ authToken, signature, url, params }) {
  if (!authToken || !signature || !url) return false;
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(twilioSignatureBase(url, params || {}), 'utf-8'))
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
