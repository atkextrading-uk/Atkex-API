require("dotenv").config();
const app = require("./app");

const PORT = process.env.PORT || 4999;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
