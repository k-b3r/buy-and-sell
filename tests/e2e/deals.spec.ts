import { expect, test } from '@playwright/test'
import { E2E_PASSWORD } from './env'

test('the deals page renders a single search input', async ({ page }) => {
  await page.goto('/login')
  await page.getByPlaceholder('Password').fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/\/$/)

  await page.goto('/deals')
  await expect(page.getByRole('heading', { name: 'Deals', level: 1 })).toBeVisible()

  await expect(page.getByPlaceholder('Search title or product')).toHaveCount(1)
})
