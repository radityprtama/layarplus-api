'use strict';

const { Router } = require('express');
const trendingController = require('../controllers/trending.controller');

const router = Router();

router.get('/near-you', trendingController.nearYou);

module.exports = router;
