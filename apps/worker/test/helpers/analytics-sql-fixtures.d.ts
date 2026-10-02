/** Vite exposes local SQL fixture source as a string; no SQL is executed by this loader. */
declare module '*.sql?raw' {const source:string;export default source;}
