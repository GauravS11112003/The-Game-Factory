/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin for builds served away from the Vite proxy, e.g. http://192.168.1.5:8000. Empty in dev. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
