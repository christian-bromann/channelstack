/**
 * Hero decoration: the stack of channels, drawn as four floating layers with a signal
 * passing through each. Hidden on narrow screens and from assistive technology.
 */
const LAYERS = ["notion", "linear", "github", "slack"];

export function StackArt() {
  return (
    <div className="stack-art" aria-hidden="true">
      <div className="stack-scene">
        {LAYERS.map((name) => (
          <div key={name} className="layer">
            <span className="layer-name">{name}.localhost</span>
            <span className="layer-lines">
              <i />
              <i />
              <i />
            </span>
            <span className="layer-signal">
              <i />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
