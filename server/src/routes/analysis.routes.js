
import { Router } from 'express';

import {
  createAnalysisJobController,
  getAnalysisJobController,
} from '../controllers/analysis.controller.js';

import {
  getAnalysisJobFilesController,
} from '../controllers/analysis-files.controller.js';

import {
  getAnalysisJobAstController,
} from '../controllers/analysis-ast.controller.js';

const router = Router();

router.post('/jobs', createAnalysisJobController);

router.get(
  '/jobs/:jobId/files',
  getAnalysisJobFilesController,
);

router.get(
  '/jobs/:jobId/ast',
  getAnalysisJobAstController,
);

router.get('/jobs/:jobId', getAnalysisJobController);

export default router;
