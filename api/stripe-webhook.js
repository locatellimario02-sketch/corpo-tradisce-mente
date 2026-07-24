const crypto = require('crypto');

// Reads the raw request body (needed to verify Stripe's signature —
// it must be checked against the exact bytes Stripe sent, not a re-parsed object).
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Verifies the Stripe-Signature header without needing the `stripe` npm package.
function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.split('='))
  );
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  if (expected !== parts.v1) {
    throw new Error('Signature mismatch');
  }
  // Reject events older than 5 minutes to prevent replay attacks.
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (age > 300) {
    throw new Error('Timestamp too old');
  }
}

// Hash a value the way Meta's Conversions API requires: SHA-256 of the
// trimmed, lowercased input.
function hashSHA256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

// Sends a server-side Purchase event to Meta's Conversions API.
// This complements the browser Pixel (which loses ~half the events to iOS,
// ad-blockers and cookie refusals). Deduplicated with the browser event via
// event_id = Stripe checkout session id (the browser must fire the same id).
async function sendMetaPurchase(session, email) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) {
    console.log('META_CAPI_TOKEN not set — skipping Conversions API');
    return;
  }
  const pixelId = process.env.META_PIXEL_ID || '1633787111176715';

  const userData = { em: [hashSHA256(email)] };
  const phone = session.customer_details?.phone;
  if (phone) userData.ph = [hashSHA256(phone)];

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: session.id, // must match the browser Pixel eventID to dedup
        action_source: 'website',
        event_source_url: 'https://evolvitiii.com/grazie.html',
        user_data: userData,
        custom_data: {
          value: (session.amount_total || 1997) / 100,
          currency: (session.currency || 'eur').toUpperCase(),
        },
      },
    ],
  };

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error('Meta CAPI error:', res.status, errText);
    }
  } catch (err) {
    console.error('Error calling Meta CAPI:', err.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const rawBody = await getRawBody(req);

  try {
    verifyStripeSignature(
      rawBody.toString('utf8'),
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send('Invalid signature');
    return;
  }

  const event = JSON.parse(rawBody.toString('utf8'));

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Only process purchases of "Il corpo tradisce la mente". This webhook
    // receives checkout.session.completed for EVERY product sold on the Stripe
    // account, so without this guard buyers of other products would be added to
    // this book's Brevo list and receive its ebooks for free.
    const OUR_PAYMENT_LINK =
      process.env.STRIPE_PAYMENT_LINK_ID || 'plink_1TtpetFyO2awdoWuF1oDPpBl';

    if (session.payment_link !== OUR_PAYMENT_LINK) {
      console.log(
        'Skipping checkout from different payment link:',
        session.payment_link
      );
      res.status(200).json({ received: true, skipped: true });
      return;
    }

    const email = session.customer_details?.email || session.customer_email;

    if (email) {
      try {
        const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
          method: 'POST',
          headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email,
            listIds: [Number(process.env.BREVO_LIST_ID)],
            updateEnabled: true,
          }),
        });

        if (!brevoRes.ok) {
          const errText = await brevoRes.text();
          console.error('Brevo API error:', brevoRes.status, errText);
        }
      } catch (err) {
        console.error('Error calling Brevo:', err.message);
      }

      // Server-side Purchase event to Meta (deduplicated with the browser Pixel).
      await sendMetaPurchase(session, email);
    } else {
      console.error('No email found on checkout session', session.id);
    }
  }

  res.status(200).json({ received: true });
};
