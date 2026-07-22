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
    } else {
      console.error('No email found on checkout session', session.id);
    }
  }

  res.status(200).json({ received: true });
};
