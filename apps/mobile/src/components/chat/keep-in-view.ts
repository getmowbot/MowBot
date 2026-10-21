import { createContext, useContext } from 'react';

/** Something on screen that can be measured (a text field). */
export interface Measurable {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

/**
 * Given by the conversation to the forms inside its messages: scrolls so a field typed into
 * stays in view, between the header and the message bar lifted by the keyboard.
 */
export const KeepInViewContext = createContext<(field: Measurable) => void>(() => {});

export function useKeepInView(): (field: Measurable) => void {
  return useContext(KeepInViewContext);
}
