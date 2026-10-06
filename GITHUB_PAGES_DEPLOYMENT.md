# Deploy Openmukti Audiobook Studio to `img2vid.github.io/SOFTWARETITLE`

This repository is a **separate project repository**. Do not push it to the existing `img2vid` repository.

## 1. Create the new repository

1. Sign in to GitHub.
2. Open https://github.com/new.
3. Under **Owner**, select `img2vid`.
4. Under **Repository name**, enter exactly:

   ```text
   SOFTWARETITLE
   ```

   Replace `SOFTWARETITLE` with the name you want in the final URL.

5. Choose **Public** unless your GitHub plan supports private Pages.
6. Do **not** add a README, `.gitignore`, or license.
7. Click **Create repository**.

The resulting Pages URL will be:

```text
https://img2vid.github.io/SOFTWARETITLE/
```

## 2. Upload this project

From the folder created after extracting the ZIP:

```bash
git init -b main
git add .
git commit -m "Initial Openmukti Audiobook Studio release"
git remote add origin https://github.com/img2vid/SOFTWARETITLE.git
git push -u origin main
```

If GitHub now requires a personal access token, use that as the password. Never commit the token.

## 3. Enable GitHub Pages

1. Open `https://github.com/img2vid/SOFTWARETITLE/settings/pages`.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open `https://github.com/img2vid/SOFTWARETITLE/settings/variables/actions`.
4. Add this repository variable if you want browsers to download the AI model on demand:

   ```text
   AUTOBOOK_MODEL = none
   ```

   With `none`, the Pages build is smaller and faster. The patched app can download the selected AI model from Hugging Face when it is missing.

   Alternatives:

   - `AUTOBOOK_MODEL = 135m` bundles the small model into the deployed site.
   - `AUTOBOOK_MODEL = 360m` bundles the default larger model.
   - Omit the variable to use the workflow's default.

## 4. Deploy

1. Open `https://github.com/img2vid/SOFTWARETITLE/actions`.
2. Select **Deploy to GitHub Pages**.
3. Choose **Run workflow**.
4. Wait for the **build** and **deploy** jobs to finish.
5. Visit:

   ```text
   https://img2vid.github.io/SOFTWARETITLE/
   ```

After the first deployment, every push to `main` automatically rebuilds and republishes the site.
