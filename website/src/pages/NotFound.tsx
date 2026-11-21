import { Link } from "react-router-dom";

import { Footer } from "../components/Footer";
import { Nav } from "../components/Nav";
import { Seo } from "../components/Seo";

export function Component() {
  return (
    <>
      <Seo title="Page not found · channelstack" path="/404" noindex />
      <Nav />
      <main id="main" className="wrap notfound">
        <p className="kicker">404</p>
        <h1>No reply in this thread.</h1>
        <p>The page you asked for doesn’t exist, or it moved.</p>
        <Link className="btn primary" to="/">
          Back to the home page
        </Link>
      </main>
      <Footer />
    </>
  );
}
