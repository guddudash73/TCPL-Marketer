import { installTestBudgetEnv } from "./budget-env.js";
import { installTestServiceSecrets } from "./service-auth.js";

// Every test worker gets per-caller test secrets; a real .env is never loaded here.
installTestServiceSecrets();
// Generous provider caps so unrelated tests are not refused; budget tests set their own.
installTestBudgetEnv();
