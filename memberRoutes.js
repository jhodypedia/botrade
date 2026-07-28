const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getMemberOverview, activateSubscription } = require('../services/subscriptionService');
const router = express.Router();
router.get('/', requireAuth, async (req, res) => {
  const overview = await getMemberOverview(req.session.user.id);
  res.render('pages/member/index', { title: 'Member Area', ...overview });
});
router.post('/activate-demo', requireAuth, async (req, res) => {
  try {
    await activateSubscription(req.body.invoice_code);
    req.session.flash = { type: 'success', message: 'Subscription berhasil diaktifkan untuk demo flow.' };
  } catch (error) {
    req.session.flash = { type: 'error', message: error.message || 'Aktivasi gagal.' };
  }
  res.redirect('/member');
});
module.exports = router;
