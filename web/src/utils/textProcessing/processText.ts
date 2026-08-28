import { rules } from './textRules';
import type { TextRule } from './textRules';

export const processText = (
    text: string = '',
    customRules: TextRule[] = rules
): string =>
    customRules.reduce(
        (acc, rule) => rule(acc),
        text
    );
