// The UI is one HTML file, compiled into the binary as text. Only the binary's entry imports this
// module: the app itself takes the page as an option, so it runs without Bun's loaders too.
import page from "../../../ui/index.html" with { type: "text" };

// Bun's types describe an HTML import as a bundle to serve; imported as text, it is the file's text.
export const UI_PAGE = page as unknown as string;
