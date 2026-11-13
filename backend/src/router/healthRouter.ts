import { Router } from "express";
import { getHealth } from "../controller/healthController";

// Volontairement hors `authorization` et hors `requireCsrfHeader` : cette route
// doit répondre à un moniteur de disponibilité externe (UptimeRobot, Better
// Stack…), qui n'a ni cookie de session ni jeton CSRF. Le détail opérationnel
// est en revanche réservé au porteur de HEALTH_KEY, voir le contrôleur.
const healthRouter = Router();

healthRouter.get("/", getHealth);

export default healthRouter;
