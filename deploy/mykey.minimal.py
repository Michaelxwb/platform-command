# GenericAgent 最小配置（由 provision-user.sh 生成，填好 3 个值即可启动）
# 高级配置（Claude 原生协议、多渠道故障转移等）参考 GA 官方模板：
#   docker run --rm --entrypoint cat <镜像> /opt/generic-agent/mykey_template.py

native_oai_config = {
    'name': 'primary',
    'apikey': '<FILL_APIKEY>',                  # 1. LLM API key
    'apibase': '<FILL_APIBASE>',                # 2. 接口地址，如 https://api.openai.com/v1
    'model': '<FILL_MODEL>',                    # 3. 模型名，如 gpt-5.4 / kimi-k2-turbo-preview
    'max_retries': 3,
}

mixin_config = {
    'llm_nos': ['primary'],
    'max_retries': 10,
    'base_delay': 0.5,
}

# ── 仅走 IM 渠道时需要（身份绑定：allowed_users 必须限定为该用户本人，禁止 ['*']）──
# wecom_bot_id = ''
# wecom_secret = ''
# wecom_allowed_users = ['<该用户的企微账号>']
# dingtalk_client_id = ''
# dingtalk_client_secret = ''
# dingtalk_allowed_users = ['<该用户的钉钉 staff id>']
# tg_bot_token = ''
# tg_allowed_users = [<该用户的 TG 数字 id>]
