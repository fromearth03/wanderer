import { Link } from 'react-router-dom';
import { ex } from '../explain';

export function NoTarget({ title }: { title: string }) {
  return (
    <div className="page">
      <div className="panel empty">
        <h3>{title} needs a target</h3>
        <p>Choose a place in the sky first: search for an object, type coordinates or click on the sky map.</p>
        <Link className="btn btn-primary" to="/explore" data-explain={ex('common.goExplore')}>
          Choose a target
        </Link>
      </div>
    </div>
  );
}
