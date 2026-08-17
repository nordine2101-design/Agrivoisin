/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone', // Empêche Vercel de boucler à l'infini sur le build
  swcMinify: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
