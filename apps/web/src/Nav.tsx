import { NavLink } from 'react-router-dom';

export function Nav() {
  return (
    <nav className="nav" aria-label="Main">
      <NavLink to="/" end>
        Jobs
      </NavLink>
      <NavLink to="/documents">My documents</NavLink>
    </nav>
  );
}
