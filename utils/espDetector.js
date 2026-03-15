/**
 * Detects which Email Service Provider (ESP) a brand uses.
 * Inspects page source, form HTML, and network URLs.
 */

const ESP_SIGNATURES = [
  {
    name:     'klaviyo',
    patterns: [/klaviyo\.com/i, /klaviyoForms/i, /kl_email/i, /__kla_id/i, /klaviyo-form/i]
  },
  {
    name:     'mailchimp',
    patterns: [/mailchimp\.com/i, /list-manage\.com/i, /mc\.us\d+\.list-manage/i, /mc-embedded-subscribe/i]
  },
  {
    name:     'omnisend',
    patterns: [/omnisend\.com/i, /omnisendContactsWidget/i]
  },
  {
    name:     'privy',
    patterns: [/privy\.com/i, /privywidget/i, /PrivyAPI/i]
  },
  {
    name:     'drip',
    patterns: [/drip\.com/i, /getdrip\.com/i, /DripSignup/i]
  },
  {
    name:     'activecampaign',
    patterns: [/activecampaign\.com/i, /activehosted\.com/i, /ac-adapter/i]
  },
  {
    name:     'hubspot',
    patterns: [/hubspot\.com/i, /hs-form/i, /hsforms\.net/i, /hubspotforms/i]
  },
  {
    name:     'brevo',
    patterns: [/brevo\.com/i, /sendinblue\.com/i, /sib-form/i]
  },
  {
    name:     'constantcontact',
    patterns: [/constantcontact\.com/i, /ctct\.net/i]
  },
  {
    name:     'convertkit',
    patterns: [/convertkit\.com/i, /ck-form/i, /convertkit-form/i]
  },
  {
    name:     'attentive',
    patterns: [/attentivemobile\.com/i, /attn\.tv/i]
  },
  {
    name:     'postscript',
    patterns: [/postscript\.io/i, /postscript-popup/i]
  },
  {
    name:     'yotpo',
    patterns: [/yotpo\.com/i, /yotpo-sms/i]
  },
  {
    name:     'iterable',
    patterns: [/iterable\.com/i, /app\.iterable\.com/i]
  },
  {
    name:     'sendgrid',
    patterns: [/sendgrid\.com/i, /sendgrid\.net/i]
  },
  {
    name:     'sfmc',
    patterns: [/exacttarget\.com/i, /salesforce\.com.*marketing/i, /mc\.s\d+\.exacttarget/i]
  }
];

function detectFromHtml(html) {
  if (!html) return 'unknown';
  for (const esp of ESP_SIGNATURES) {
    if (esp.patterns.some(p => p.test(html))) return esp.name;
  }
  return 'unknown';
}

function detectFromNetworkUrls(urls) {
  for (const url of urls) {
    for (const esp of ESP_SIGNATURES) {
      if (esp.patterns.some(p => p.test(url))) return esp.name;
    }
  }
  return 'unknown';
}

function extractKlaviyoCompanyId(html) {
  const match = html.match(/klaviyo\.com\/api\/website_identify\?data=([^"&]+)/);
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString();
      const data = JSON.parse(decoded);
      return data.company_id || null;
    } catch { return null; }
  }
  const initMatch = html.match(/klaviyo\.init\(["']([A-Za-z0-9]+)["']/);
  return initMatch ? initMatch[1] : null;
}

function getEspApiEndpoint(espName, companyId) {
  switch (espName) {
    case 'klaviyo':
      if (companyId) return `https://manage.kmail-lists.com/ajax/subscriptions/subscribe`;
      return null;
    default:
      return null;
  }
}

module.exports = { detectFromHtml, detectFromNetworkUrls, extractKlaviyoCompanyId, getEspApiEndpoint };
