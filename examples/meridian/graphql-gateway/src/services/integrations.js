const fetch = require('node-fetch');

async function fetchInvoiceDocument(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    timeout: 10000,
    headers: { 'User-Agent': 'Meridian-InvoiceImporter/1.0' },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch invoice from ${url}: ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  const text = await res.text();
  return parseInvoiceText(text);
}

function parseInvoiceText(text) {
  const vendorMatch = text.match(/vendor[:\s]+([^\n<]+)/i);
  const amountMatch = text.match(/total[:\s]+\$?([\d,.]+)/i);

  return {
    vendor: vendorMatch ? vendorMatch[1].trim() : 'Unknown Vendor',
    amountCents: amountMatch
      ? Math.round(parseFloat(amountMatch[1].replace(/,/g, '')) * 100)
      : 0,
  };
}

async function fetchExchangeRate(baseCurrency) {
  const res = await fetch(`https://api.exchangerate.host/latest?base=${baseCurrency}`);
  if (!res.ok) return { rates: {} };
  return res.json();
}

module.exports = { fetchInvoiceDocument, parseInvoiceText, fetchExchangeRate };
