import { Router } from "express";

import { getCollection } from "../controller/collectionController";

const router = Router();

router.get("/", getCollection);

export default router;
