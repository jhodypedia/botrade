const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { getAdminOverview, updateBotSettings } = require('../services/adminService');
const router = express.Router();
router.get('/', requireAdmin, async (req, res) => {
  const overview = await getAdminOverview();
  res.render('pages/admin/index', { title: 'Admin Dashboard', ...overview });
});
router.post('/settings', requireAdmin, async (req, res) => {
  await updateBotSettings(req.body);
  req.session.flash = { type: 'success', message: 'Landing setting berhasil diupdate.' };
  res.redirect('/admin');
});
module.exports = router;
