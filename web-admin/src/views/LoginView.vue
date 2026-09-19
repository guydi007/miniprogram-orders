<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand-mark">工</div>
      <h1>工单管理后台</h1>
      <p class="login-subtitle">电脑端客服 / 主管工作台</p>

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="员工手机号">
          <el-input v-model.trim="form.username" maxlength="11" size="large" placeholder="请输入员工预留手机号" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password size="large" placeholder="请输入网页登录密码" @keyup.enter="submit" />
        </el-form-item>
        <el-button class="login-button" type="primary" size="large" :loading="loading" @click="submit">登录</el-button>
      </el-form>

      <div class="login-tip">
        网页账号由 CloudBase 身份认证管理；首次登录会自动核验已绑定手机号，并关联到对应员工。
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { session } from '../stores/session'

const router = useRouter()
const route = useRoute()
const loading = ref(false)
const form = reactive({ username: '', password: '' })

async function submit() {
  if (loading.value) return
  if (!/^1\d{10}$/.test(form.username)) {
    return ElMessage.warning('请输入11位员工手机号')
  }
  if (!form.password) return ElMessage.warning('请输入密码')
  loading.value = true
  try {
    await session.login(form.username, form.password)
    ElMessage.success('登录成功')
    router.replace(String(route.query.redirect || '/orders'))
  } catch (error) {
    ElMessage.error(error.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>
