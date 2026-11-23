import { installTestServiceSecrets } from "./service-auth.js";

// Every test worker gets per-caller test secrets; a real .env is never loaded here.
installTestServiceSecrets();
