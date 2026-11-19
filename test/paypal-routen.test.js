// PayPal-Routen in server.js, gestartet im Kindprozess ohne .env und ohne Datenbank
// (testhilfe/). PayPal ist entweder nicht eingerichtet (fetch gesperrt) oder wird
// vorgetaeuscht (PAYPAL_ATTRAPPE). Nie eine Anfrage an das echte PayPal. npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const { starteServer } = require('../testhilfe/server-probe');

const KUNDE = { first: 'Max', last: 'Muster', email: 'max@example.org', phone: '0123', street: 'Weg', house: '1', city: 'Beckum' };
// So schickt index.html eine Online-Bestellung (redirectToOnlinePayment)
function rumpf(extra = {}) {
  return { items: [{ name: 'Pizza Margherita', price: 8.5, qty: 2, extraDetails: [], note: '' },
                   { name: 'Cola', price: 2.5, qty: 1, extraDetails: [], note: '' }],
           subtotal: 19.5, discount: 0, deliveryFee: 0, serviceFee: 0.99, total: 1.00,   // total vom Gast: wird ignoriert
           // Abholung: das Lieferfenster haengt an der Uhrzeit, der Test soll es nicht
           mode: 'abholung', note: 'klingeln', coupon: null, customer: KUNDE, ...extra };
}
const post = (s, pfad, body, admin = false) => s.holen(pfad, { method: 'POST', admin, body: JSON.stringify(body) });

test('ohne PayPal-Werte: paypal:false, alle PayPal-Routen lehnen ab, keine Anfrage nach aussen', async () => {
  const s = await starteServer();
  try {
    const c = await s.holen('/api/config', { admin: false });
    assert.equal(c.json.paypal, false);
    assert.deepEqual(Object.keys(c.json), ['whatsapp', 'serviceFee', 'deliveryCities', 'paypal']);
    const o = await post(s, '/api/create-paypal-order', rumpf());
    assert.equal(o.status, 503); assert.equal(o.json.paypal, false); assert.ok(!o.json.url);
    assert.equal((await post(s, '/api/paypal-capture', { paypalOrderId: 'ABCDEF123' })).status, 503);
    assert.equal((await post(s, '/api/paypal-webhook', { event_type: 'PAYMENT.CAPTURE.COMPLETED' })).status, 503);
    assert.equal((await s.holen('/api/admin/paypal', { admin: false })).status, 401);
    const st = await s.holen('/api/admin/paypal');
    assert.equal(st.status, 200);
    assert.equal(st.json.modus, 'aus'); assert.equal(st.json.fuerGaesteSichtbar, false);
    assert.match(s.log, /PayPal nicht eingerichtet/);
    assert.ok(!s.log.includes('FETCH-GESPERRT') && !s.log.includes('GESPEICHERT'), s.log);
  } finally { s.stop(); }
});

test('Schluessel ohne PAYPAL_ENV=live: Warnzeile, paypal:false, keine Anfrage, Status ohne Geheimnisse', async () => {
  const env = { PAYPAL_CLIENT_ID: 'FANTASIE-ID-1234', PAYPAL_CLIENT_SECRET: 'FANTASIE-GEHEIM-5678' };
  for (const PAYPAL_ENV of [undefined, 'sandbox', 'Live']) {
    const s = await starteServer({ env: { ...env, ...(PAYPAL_ENV ? { PAYPAL_ENV } : {}) } });
    try {
      assert.equal((await s.holen('/api/config', { admin: false })).json.paypal, false);
      assert.equal((await post(s, '/api/create-paypal-order', rumpf())).status, 503);
      const st = await s.holen('/api/admin/paypal');
      assert.equal(st.status, 200);
      assert.ok(!st.text.includes('FANTASIE'), st.text);
      assert.match(s.log, /PAYPAL_ENV ist nicht "live"/);
      assert.ok(!s.log.includes('FETCH-GESPERRT'), s.log);
    } finally { s.stop(); }
  }
});

test('PayPal vorgetaeuscht: paypal:true, Bestellung mit Betrag vom Server und denselben Pruefungen wie Stripe', async () => {
  const s = await starteServer({ env: { PAYPAL_ATTRAPPE: '1', PAYPAL_ENV: 'live',
    PAYPAL_CLIENT_ID: 'FANTASIE-ID-1234', PAYPAL_CLIENT_SECRET: 'FANTASIE-GEHEIM-5678' } });
  try {
    // Webhook wird beim Start sichergestellt (in der Attrappe schon vorhanden)
    for (let i = 0; i < 50 && !s.log.includes('PayPal wird angeboten'); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await s.holen('/api/config', { admin: false })).json.paypal, true);

    const anlegen = () => (s.log.match(/PAYPAL-ATTRAPPE POST \/v2\/checkout\/orders/g) || []).length;
    // Pruefungen vor PayPal: ohne Kundendaten, Warenkorb passt nicht, ungueltige Art
    assert.equal((await post(s, '/api/create-paypal-order', rumpf({ customer: undefined }))).status, 400);
    assert.equal((await post(s, '/api/create-paypal-order', rumpf({ subtotal: 1 }))).status, 400);
    assert.equal((await post(s, '/api/create-paypal-order', rumpf({ items: [] }))).status, 400);
    assert.equal((await post(s, '/api/create-paypal-order', rumpf({ mode: 'drohne' }))).status, 400);
    // Wie create-stripe-checkout: Mittagsangebote nur zur Abholung. Liefert ATAS gerade nicht
    // (Lieferfenster wie POST /api/orders), lehnt schon das Lieferfenster mit 409 ab.
    const mittag = rumpf({ mode: 'lieferung', deliveryFee: 2,
      items: [{ name: 'Menü 1: Atas-Tasche', price: 9, qty: 1, extraDetails: [], note: '' }], subtotal: 9 });
    assert.equal((await post(s, '/api/create-paypal-order', mittag)).status, 409);
    // Grillhaehnchen nur samstags ab 13:00 (bestellSperre wie bei Stripe): ausser samstags nachmittags 409
    const huhn = rumpf({ items: [{ name: 'Ein Hähnchenschenkel', price: 5, qty: 1, extraDetails: [], note: '' }], subtotal: 5 });
    const jetzt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    if (!(jetzt.getDay() === 6 && jetzt.getHours() >= 13)) {
      assert.equal((await post(s, '/api/create-paypal-order', huhn)).status, 409);
    }
    assert.equal(anlegen(), 0, 'PayPal darf vor bestandenen Pruefungen nicht gefragt werden');

    const o = await post(s, '/api/create-paypal-order', rumpf());
    assert.equal(o.status, 200, o.text);
    assert.match(o.json.url, /^https:\/\/www\.paypal\.com\//);
    assert.equal(anlegen(), 1);
    const pp = JSON.parse(s.log.match(/PAYPAL-ATTRAPPE POST \/v2\/checkout\/orders (\{.*\})/)[1]);
    assert.equal(pp.purchase_units[0].amount.value, '20.49');          // 19,50 + 0,99 (nicht 1,00)
    assert.equal(pp.purchase_units[0].custom_id, String(o.json.orderNum));
    const gespeichert = JSON.parse(s.log.match(/GESPEICHERT Order (\{.*\})/)[1]);
    assert.equal(gespeichert.payment, 'paypal');
    assert.equal(gespeichert.status, 'awaiting_payment');
    assert.equal(gespeichert.paymentStatus, 'pending');
    assert.equal(gespeichert.paypalOrderId, 'PPATTRAPPE123');
    assert.equal(gespeichert.total, 20.49);
    assert.equal(gespeichert.discount, 0);

    // Rabatt wie bei Stripe serverseitig: ATAS fuehrt keine Aktion (RABATT_AKTIV false),
    // ein mitgeschickter Code und ein Rabatt vom Gast werden ignoriert
    const gross = rumpf({ items: [{ name: 'Familienpizza', price: 25, qty: 3, extraDetails: [], note: '' }], subtotal: 75,
      coupon: 'ATAS-KEIN-RABATT', discount: 30 });
    const r = await post(s, '/api/create-paypal-order', gross);
    assert.equal(r.status, 200, r.text);
    const alle = [...s.log.matchAll(/PAYPAL-ATTRAPPE POST \/v2\/checkout\/orders (\{.*\})/g)];
    assert.equal(JSON.parse(alle[1][1]).purchase_units[0].amount.value, '75.99');   // 75 + 0,99, kein Rabatt
    const g2 = [...s.log.matchAll(/GESPEICHERT Order (\{.*\})/g)].map(m => JSON.parse(m[1]))[1];
    assert.equal(g2.discount, 0); assert.equal(g2.coupon, null);
    assert.equal(anlegen(), 2);
    assert.ok(!s.log.includes('FETCH-GESPERRT'), s.log);
  } finally { s.stop(); }
});
