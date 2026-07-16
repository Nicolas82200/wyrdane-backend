import { Router } from "express";

import { getOne } from "../controller/userController";

const router = Router();

// GET http://localhost:3000/api/users/1
router.get("/:id", getOne);

export default router;
