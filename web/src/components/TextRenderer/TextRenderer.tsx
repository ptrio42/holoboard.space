import React, {useMemo} from 'react';
import {processText} from "../../utils/textProcessing/processText";
import DOMPurify from 'dompurify';

type Props = {
    text: string;
};

const TextRenderer: React.FC<Props> = ({ text }) => {
    const safeHtml = useMemo(() => {
        const html = processText(text);

        return DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['br', 'img'],
            ALLOWED_ATTR: ['src', 'alt', 'loading'],
        });
    }, [text]);

    return (
        <div
            className="text-content"
            dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
    );
};

export default TextRenderer;
