import { Fragment } from 'react';
import { splitByMatches } from '../lib/search-highlight';

interface HighlightedTextProps {
  text: string | null | undefined;
  /**
   * 已经解析好的命中词。由调用方 `useMemo` 后传入，
   * 避免虚拟列表里每一行都重新解析一次查询串。
   */
  terms: string[];
}

/** 把命中的片段包成 `<mark class="search-hit">`，其余原样输出。 */
export function HighlightedText({ text, terms }: HighlightedTextProps): JSX.Element {
  const source = text ?? '';
  if (!source || terms.length === 0) return <>{source}</>;

  const segments = splitByMatches(source, terms);
  return (
    <>
      {segments.map((segment, index) =>
        segment.hit ? (
          <mark key={index} className="search-hit">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}
