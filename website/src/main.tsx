import "@fontsource-variable/familjen-grotesk/wght.css";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles/base.css";
import "./styles/home.css";
import "./styles/player.css";
import "./styles/docs.css";
import "./styles/figures.css";
import { ViteReactSSG } from "vite-react-ssg";

import { routes } from "./routes";

export const createRoot = ViteReactSSG({ routes });
