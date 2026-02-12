export async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${url}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "text/plain, text/html, application/xml, text/xml",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
