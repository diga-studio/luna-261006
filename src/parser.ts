import { SaxesParser } from 'saxes';
import type {
  XmlAttribute,
  XmlDocument,
  XmlElement,
  XmlNamespaceDecl,
} from './model.js';
import { NS_XMLNS } from './namespaces.js';

/** 拒绝 DOCTYPE 与实体声明（大小写不敏感，宁可过严）。 */
const FORBIDDEN_DECLARATIONS = /<!(?:DOCTYPE|ENTITY)[\s>]/i;

/**
 * 将 UTF-8 XML 文本解析为内部节点模型。
 * 拒绝：DOCTYPE、实体声明、畸形 XML、未定义实体引用。
 * 解析器不解析、不读取任何外部资源。
 */
export function parseXml(xml: string): XmlDocument {
  if (FORBIDDEN_DECLARATIONS.test(xml)) {
    throw new Error('DOCTYPE/ENTITY declarations are not allowed');
  }

  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;

  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];
  let parseError: Error | null = null;

  const parser = new SaxesParser({ xmlns: true });

  parser.on('error', (err: Error) => {
    parseError ??= err;
  });

  parser.on('opentag', (tag) => {
    const attributes: XmlAttribute[] = [];
    const namespaceDeclarations: XmlNamespaceDecl[] = [];
    for (const qname of Object.keys(tag.attributes)) {
      const attr = tag.attributes[qname]!;
      if (attr.prefix === 'xmlns') {
        namespaceDeclarations.push({ prefix: attr.local, uri: attr.value });
      } else if (attr.name === 'xmlns') {
        namespaceDeclarations.push({ prefix: '', uri: attr.value });
      } else {
        attributes.push({
          prefix: attr.prefix,
          localName: attr.local,
          namespaceURI: attr.uri,
          value: attr.value,
        });
      }
    }
    const element: XmlElement = {
      kind: 'element',
      prefix: tag.prefix,
      localName: tag.local,
      namespaceURI: tag.uri,
      attributes,
      namespaceDeclarations,
      children: [],
      parent: null,
    };
    const parent = stack.length > 0 ? stack[stack.length - 1]! : null;
    if (parent !== null) {
      element.parent = parent;
      parent.children.push(element);
    } else if (root === null) {
      root = element;
    }
    stack.push(element);
  });

  parser.on('closetag', () => {
    stack.pop();
  });

  parser.on('text', (value: string) => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined && value !== '') {
      parent.children.push({ kind: 'text', value });
    }
  });

  parser.on('cdata', (value: string) => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.children.push({ kind: 'cdata', value });
    }
  });

  parser.on('comment', (value: string) => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.children.push({ kind: 'comment', value });
    }
  });

  parser.on('processinginstruction', (pi: { target: string; body: string }) => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.children.push({ kind: 'pi', target: pi.target, data: pi.body });
    }
  });

  parser.on('doctype', () => {
    parseError ??= new Error('DOCTYPE is not allowed');
  });

  parser.write(text).close();

  if (parseError !== null) {
    throw new Error(`malformed XML: ${(parseError as Error).message}`);
  }
  if (root === null) {
    throw new Error('document has no root element');
  }
  return { root };
}
