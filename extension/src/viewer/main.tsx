import { createRoot } from "react-dom/client";
import "./index.css";
import Viewer from "./Viewer";

const mode = document.body.dataset.mode === "float" ? "float" : "full";
createRoot(document.getElementById("root")!).render(<Viewer mode={mode} />);
