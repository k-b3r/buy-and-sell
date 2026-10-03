import { expect, test } from '@playwright/test'
import { E2E_PASSWORD } from './env'

test('an unauthenticated visitor is redirected to the login page', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Dashboard login' })).toBeVisible()
})

test('a wrong password stays on the login page with an error', async ({ page }) => {
  await page.goto('/login')
  await page.getByPlaceholder('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Log in' }).click()

  await expect(page).toHaveURL(/\/login\?error=1$/)
})

test('the right password opens the products page, served through the server from postgres', async ({ page }) => {
  await page.goto('/login')
  await page.getByPlaceholder('Password').fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible()
})
