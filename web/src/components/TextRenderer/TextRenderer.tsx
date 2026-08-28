import React, { useMemo } from 'react';
import { processText } from "../../utils/textProcessing/processText";
import DOMPurify from 'dompurify';

type Props = {
    text: string;
};

const TextRenderer: React.FC<Props> = ({ text }) => {
    const safeHtml = useMemo(() => {
        const html = processText(text);

        return DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['br', 'img', 'a'],
            ALLOWED_ATTR: ['src', 'alt', 'loading', 'decoding', 'href', 'target', 'rel'],
            ALLOWED_URI_REGEXP: /^https?:\/\//i,
        });
    }, [text]);

    return (
        <div
            className="note-body"
            dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
    );
};

export default TextRenderer;
