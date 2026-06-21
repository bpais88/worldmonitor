// Slack delivery via an incoming webhook. --dry-run logs instead of posting.

export async function postSlack(webhookUrl, text, { dryRun = false } = {}) {
  if (dryRun || !webhookUrl) {
    console.log('[dry-run] would send to Slack:\n' + text);
    return true;
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`slack ${res.status}`);
  return true;
}
