import React from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./dashboard/Dashboard";
import { createBridge } from "./bridge";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("ActionDeck root element is missing");
}

createRoot(root).render(<Dashboard bridge={createBridge()} />);
