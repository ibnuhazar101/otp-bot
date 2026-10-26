/**
 * OTP extraction.
 *
 * A message is a candidate when its sender ("From") or subject matches the
 * provider's senderPattern. The code is then extracted with the provider's
 * otpRegex — preferring the subject (Canva/Spotify put the code there), then
 * the text body (ChatGPT puts it there).
 */

export interface OtpMatcher {
  senderPattern: RegExp | null;
  otpRegex: RegExp;
}

export interface ParsedMessage {
  from: string;
  subject: string;
  text: string;
}

/**
 * Attempts to extract an OTP from a message using the given matcher (a
 * provider). Returns the code string, or null if the message isn't a match.
 */
export function extractOtp(matcher: OtpMatcher, msg: ParsedMessage): string | null {
  if (matcher.senderPattern) {
    const haystack = `${msg.from}\n${msg.subject}`;
    if (!matcher.senderPattern.test(haystack)) {
      return null;
    }
  }

  // Subject first (Canva/Spotify), then body (ChatGPT).
  for (const source of [msg.subject, msg.text]) {
    if (!source) continue;
    // Reset lastIndex in case a global flag ever sneaks into the config regex.
    matcher.otpRegex.lastIndex = 0;
    const match = matcher.otpRegex.exec(source);
    if (match) {
      const code = (match[1] ?? match[0]).trim();
      if (code) return code;
    }
  }

  return null;
}
