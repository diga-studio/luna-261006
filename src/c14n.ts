import type { XmlAttribute, XmlElement } from './model.js';
import { qualifiedName } from './model.js';
import { NS_XML } from './namespaces.js';

export interface C14nOptions {
  /** InclusiveNamespaces PrefixList（可含 "#default"）。 */
  readonly inclusivePrefixes?: readonly string[];
  /** enveloped-signature 变换：遍历到该元素时整体跳过。 */
  readonly skip?: XmlElement;
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#xD;');
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\t', '&#x9;')
    .replaceAll('\n', '&#xA;')
    .replaceAll('\r', '&#xD;');
}

/** 沿元素及其祖先查找前缀的生效命名空间 URI；未找到返回 undefined。 */
function inScopeNamespace(el: XmlElement, prefix: string): string | undefined {
  let current: XmlElement | null = el;
  while (current !== null) {
    for (const decl of current.namespaceDeclarations) {
      if (decl.prefix === prefix) {
        return decl.uri;
      }
    }
    current = current.parent;
  }
  return undefined;
}

function compareAttributes(a: XmlAttribute, b: XmlAttribute): number {
  if (a.namespaceURI !== b.namespaceURI) {
    return a.namespaceURI < b.namespaceURI ? -1 : 1;
  }
  if (a.localName !== b.localName) {
    return a.localName < b.localName ? -1 : 1;
  }
  return 0;
}

function attributeQualifiedName(attr: XmlAttribute): string {
  return attr.prefix === '' ? attr.localName : `${attr.prefix}:${attr.localName}`;
}

interface RenderContext {
  /** 输出文档中已生效的命名空间（prefix -> uri）。 */
  readonly rendered: ReadonlyMap<string, string>;
  readonly inclusivePrefixes: ReadonlySet<string>;
  readonly skip: XmlElement | undefined;
}

function renderElement(el: XmlElement, ctx: RenderContext, out: string[]): void {
  if (el === ctx.skip) {
    return;
  }

  const decls = new Map<string, string>();

  // 元素自身命名空间：visibly utilized。
  if (el.prefix !== '') {
    if (ctx.rendered.get(el.prefix) !== el.namespaceURI) {
      decls.set(el.prefix, el.namespaceURI);
    }
  } else if (el.namespaceURI !== '') {
    if (ctx.rendered.get('') !== el.namespaceURI) {
      decls.set('', el.namespaceURI);
    }
  } else if (ctx.rendered.has('') && ctx.rendered.get('') !== '') {
    decls.set('', '');
  }

  // 属性命名空间：visibly utilized（xml: 前缀隐含绑定，无需声明）。
  for (const attr of el.attributes) {
    if (attr.prefix !== '' && attr.prefix !== 'xml') {
      if (ctx.rendered.get(attr.prefix) !== attr.namespaceURI) {
        decls.set(attr.prefix, attr.namespaceURI);
      }
    }
  }

  // InclusiveNamespaces PrefixList：按 inclusive 规则处理。
  for (const prefix of ctx.inclusivePrefixes) {
    const uri = inScopeNamespace(el, prefix);
    if (uri !== undefined && ctx.rendered.get(prefix) !== uri) {
      decls.set(prefix, uri);
    }
  }

  const rendered = new Map(ctx.rendered);
  for (const [prefix, uri] of decls) {
    rendered.set(prefix, uri);
  }

  const sortedDecls = [...decls.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const sortedAttrs = [...el.attributes].sort(compareAttributes);

  let open = `<${qualifiedName(el)}`;
  for (const [prefix, uri] of sortedDecls) {
    open += prefix === '' ? ` xmlns="${uri}"` : ` xmlns:${prefix}="${uri}"`;
  }
  for (const attr of sortedAttrs) {
    open += ` ${attributeQualifiedName(attr)}="${escapeAttribute(attr.value)}"`;
  }
  open += '>';
  out.push(open);

  const childCtx: RenderContext = { ...ctx, rendered };
  for (const child of el.children) {
    switch (child.kind) {
      case 'element':
        renderElement(child, childCtx, out);
        break;
      case 'text':
      case 'cdata':
        out.push(escapeText(child.value));
        break;
      case 'comment':
        break;
      case 'pi':
        out.push(
          child.data === '' ? `<?${child.target}?>` : `<?${child.target} ${child.data}?>`,
        );
        break;
    }
  }

  out.push(`</${qualifiedName(el)}>`);
}

/**
 * Exclusive XML Canonicalization（不含注释）。
 * 输出以 root 为顶点的子树的规范化八位组（UTF-8 字符串形式）。
 */
export function canonicalize(root: XmlElement, options?: C14nOptions): string {
  const inclusivePrefixes = new Set<string>();
  for (const prefix of options?.inclusivePrefixes ?? []) {
    inclusivePrefixes.add(prefix === '#default' ? '' : prefix);
  }
  const ctx: RenderContext = {
    rendered: new Map(),
    inclusivePrefixes,
    skip: options?.skip,
  };
  const out: string[] = [];
  renderElement(root, ctx, out);
  return out.join('');
}
