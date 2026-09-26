import { mount } from "svelte";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/600.css";
import "./app.css";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app")! });
