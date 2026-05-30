export function describeSessionRef(sessionRef) {
  if (!sessionRef) return null;
  return {
    sessionRef,
    type: 'browser_or_secure_store_reference',
    containsSecretMaterial: false,
    note: '仅保存会话/凭据引用；Cookie、Authorization、密码等明文必须由运行环境安全提供。'
  };
}
