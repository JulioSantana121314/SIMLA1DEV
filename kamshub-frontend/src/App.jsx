import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import Inbox from './pages/Inbox';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/inbox" element={<Inbox />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
