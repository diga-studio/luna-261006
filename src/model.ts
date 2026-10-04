/** 库内部使用的最小 XML 节点模型，由 parser 从 saxes 事件构建。 */

export interface XmlNamespaceDecl {
  /** '' 表示默认命名空间声明。 */
  readonly prefix: string;
  readonly uri: string;
}

export interface XmlAttribute {
  /** '' 表示无前缀。 */
  readonly prefix: string;
  readonly localName: string;
  /** '' 表示无命名空间。 */
  readonly namespaceURI: string;
  readonly value: string;
}

export interface XmlText {
  readonly kind: 'text';
  readonly value: string;
}

export interface XmlCdata {
  readonly kind: 'cdata';
  readonly value: string;
}

export interface XmlComment {
  readonly kind: 'comment';
  readonly value: string;
}

export interface XmlProcessingInstruction {
  readonly kind: 'pi';
  readonly target: string;
  readonly data: string;
}

export type XmlChild =
  | XmlElement
  | XmlText
  | XmlCdata
  | XmlComment
  | XmlProcessingInstruction;

export interface XmlElement {
  readonly kind: 'element';
  /** '' 表示无前缀。 */
  readonly prefix: string;
  readonly localName: string;
  /** '' 表示无命名空间。 */
  readonly namespaceURI: string;
  /** 普通属性（不含 xmlns 声明），文档顺序。 */
  readonly attributes: readonly XmlAttribute[];
  /** 本元素上声明的 xmlns / xmlns:prefix，文档顺序。 */
  readonly namespaceDeclarations: readonly XmlNamespaceDecl[];
  readonly children: XmlChild[];
  parent: XmlElement | null;
}

export interface XmlDocument {
  readonly root: XmlElement;
}

/** 元素限定名，如 "saml2p:AuthnRequest" 或 "AuthnRequest"。 */
export function qualifiedName(el: XmlElement): string {
  return el.prefix === '' ? el.localName : `${el.prefix}:${el.localName}`;
}

/** 直接子元素（跳过文本、注释等）。 */
export function childElements(el: XmlElement): XmlElement[] {
  return el.children.filter(
    (c): c is XmlElement => c.kind === 'element',
  );
}

/** 按命名空间 URI 与局部名查找直接子元素。 */
export function findChildren(
  el: XmlElement,
  namespaceURI: string,
  localName: string,
): XmlElement[] {
  return childElements(el).filter(
    (c) => c.namespaceURI === namespaceURI && c.localName === localName,
  );
}

/** 读取无命名空间属性；不存在返回 undefined。 */
export function getAttribute(el: XmlElement, localName: string): string | undefined {
  for (const attr of el.attributes) {
    if (attr.prefix === '' && attr.localName === localName) {
      return attr.value;
    }
  }
  return undefined;
}

/** 元素全部文本内容（text 与 CDATA 拼接）。 */
export function textContent(el: XmlElement): string {
  const parts: string[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.kind === 'text' || child.kind === 'cdata') {
        parts.push(child.value);
      } else if (child.kind === 'element') {
        walk(child);
      }
    }
  };
  walk(el);
  return parts.join('');
}

/** 深度优先遍历全部元素（含自身）。 */
export function* iterateElements(root: XmlElement): Generator<XmlElement> {
  yield root;
  for (const child of childElements(root)) {
    yield* iterateElements(child);
  }
}
