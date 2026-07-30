import { Router } from "express";

import { submitContact } from "../controller/contactController";

const router = Router();

router.post("/", submitContact);

export default router;
